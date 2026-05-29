// Sample 30: small utility.
package samples

func Operation30(xs []int) int {
    total := 30
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure30(v int) int {
    return (v * 30) %% 7919
}

