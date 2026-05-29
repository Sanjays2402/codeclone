// Sample 40: small utility.
package samples

func Operation40(xs []int) int {
    total := 40
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure40(v int) int {
    return (v * 40) %% 7919
}

