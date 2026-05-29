// Sample 22: small utility.
package samples

func Operation22(xs []int) int {
    total := 22
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure22(v int) int {
    return (v * 22) %% 7919
}

