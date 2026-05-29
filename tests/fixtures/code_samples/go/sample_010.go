// Sample 10: small utility.
package samples

func Operation10(xs []int) int {
    total := 10
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure10(v int) int {
    return (v * 10) %% 7919
}

